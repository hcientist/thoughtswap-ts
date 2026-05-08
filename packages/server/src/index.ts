/*
 * ThoughtSwap
 * Copyright (C) 2026 ThoughtSwap
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { authRouter } from './auth.router.js';
import { coursesRouter } from './courses.router.js';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();
const prisma = new PrismaClient();
app.use(cors());
app.use(express.json());

app.use('/accounts/canvas/login', authRouter);
app.use('/api/courses', coursesRouter);

// --- Logging Helper ---
async function logEvent(event: string, userId: string | null, payload: any) {
    try {
        await prisma.log.create({
            data: {
                event,
                userId,
                payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
            },
        });
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function shuffleThoughts(
    thoughts: { content: string; authorId: string; authorName?: string }[],
    recipientIds: string[]
): Record<string, any> {
    if (thoughts.length === 0) return {};

    let pool = [...thoughts];
    const assignments: Record<string, any> = {};

    while (pool.length < recipientIds.length) {
        pool = pool.concat(thoughts);
    }
    if (pool.length > recipientIds.length) {
        pool = pool.slice(0, recipientIds.length);
    }

    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = pool[i]!;
        pool[i] = pool[j]!;
        pool[j] = temp;
    }

    for (let i = 0; i < recipientIds.length; i++) {
        const recipient = recipientIds[i];
        const thought = pool[i];
        if (recipient && thought) {
            assignments[recipient] = {
                content: thought.content,
                authorId: thought.authorId,
                originalAuthorName: thought.authorName,
            };
        }
    }

    return assignments;
}

const roomAssignments: Record<string, Record<string, any>> = {};

async function broadcastParticipantList(joinCode: string, activePromptUseId: string | null) {
    const sockets = await io.in(joinCode).fetchSockets();

    // Get the course to identify the teacher
    const course = await prisma.course.findUnique({ where: { joinCode } });
    if (!course) return;

    const submissions = activePromptUseId
        ? await prisma.thought.findMany({ where: { promptUseId: activePromptUseId } })
        : [];

    // Build participant list from non-teacher sockets
    const participantList = sockets
        .filter((s) => s.data.userId !== course.teacherId) // Exclude teacher
        .map((s) => {
            return {
                socketId: s.id,
                name: s.data.userName || 'Anonymous',
                hasSubmitted: submissions.some((sub) => sub.authorId === s.data.userId),
            };
        });

    // Send updates to teacher sockets
    const teacherSockets = sockets.filter((s) => s.data.userId === course.teacherId);
    teacherSockets.forEach((t) => {
        t.emit('PARTICIPANTS_UPDATE', {
            participants: participantList,
            submissionCount: submissions.length,
        });
        if (roomAssignments[joinCode]) {
            t.emit('DISTRIBUTION_UPDATE', roomAssignments[joinCode]);
        }
    });
}

async function broadcastThoughtsList(joinCode: string, promptUseId: string) {
    const thoughts = await prisma.thought.findMany({
        where: { promptUseId },
        include: { author: true },
    });

    const thoughtData = thoughts.map((t) => ({
        id: t.id,
        content: t.content,
        authorName: t.author.name,
        authorId: t.authorId,
    }));

    // Get the course to identify the teacher
    const course = await prisma.course.findUnique({ where: { joinCode } });
    if (!course) return;

    const sockets = await io.in(joinCode).fetchSockets();
    const teacherSockets = sockets.filter((s) => s.data.userId === course.teacherId);
    teacherSockets.forEach((t) => {
        t.emit('THOUGHTS_UPDATE', thoughtData);
    });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: `${FRONTEND_URL}`,
        methods: ['GET', 'POST'],
    },
});

io.on('connection', (socket: Socket) => {
    const { email, name } = socket.handshake.auth;

    const userPromise = (async () => {
        if (!email) return null;
        try {
            // Handle demo users dynamically
            if (email.endsWith('@demo.com')) {
                const isTeacher = email.includes('teacher');
                return await prisma.user.upsert({
                    where: { email },
                    update: {},
                    create: {
                        email,
                        name: name || (isTeacher ? 'Guest Teacher' : 'Guest Student'),
                        canvasId: `demo-${Math.random().toString(36).substr(2, 9)}`,
                        accessToken: 'demo-token',
                    }
                });
            }
            return await prisma.user.findUnique({ where: { email } });
        } catch (e) {
            console.error('User load error', e);
            return null;
        }
    })();

    userPromise.then((user) => {
        if (!user) {
            socket.emit('AUTH_ERROR', { message: 'Session invalid. Please log in again.' });
            socket.disconnect();
        } else {
            socket.data.userId = user.id;
            socket.data.userName = user.name;
            socket.emit('CONSENT_STATUS', {
                consentGiven: user.consentGiven,
                consentDate: user.consentDate,
            });
            logEvent('USER_CONNECT', user.id, { socketId: socket.id });
        }
    });

    socket.on('UPDATE_CONSENT', async ({ consentGiven }) => {
        const user = await userPromise;
        if (!user) return;
        await prisma.user.update({
            where: { id: user.id },
            data: { consentGiven, consentDate: new Date() },
        });
        logEvent('UPDATE_CONSENT', user.id, { consentGiven });
        socket.emit('CONSENT_STATUS', { consentGiven, consentDate: new Date() });
    });

    // --- PROMPT BANK CRUD ---
    socket.on('GET_SAVED_PROMPTS', async () => {
        const user = await userPromise;
        if (!user) return;
        const prompts = await prisma.savedPrompt.findMany({
            where: { teacherId: user.id },
            orderBy: { createdAt: 'desc' },
        });
        socket.emit('SAVED_PROMPTS_LIST', prompts);
    });

    socket.on('SAVE_PROMPT', async (data) => {
        const user = await userPromise;
        if (!user) return;

        const { content, type = 'TEXT', options = [] } = data;

        await prisma.savedPrompt.create({
            data: {
                content,
                type,
                options: options || [],
                teacherId: user.id,
            },
        });
        const prompts = await prisma.savedPrompt.findMany({
            where: { teacherId: user.id },
            orderBy: { createdAt: 'desc' },
        });
        socket.emit('SAVED_PROMPTS_LIST', prompts);
        logEvent('SAVE_PROMPT', user.id, { content, type });
    });

    socket.on('DELETE_SAVED_PROMPT', async ({ id }) => {
        const user = await userPromise;
        if (!user) return;
        try {
            const prompt = await prisma.savedPrompt.findUnique({ where: { id } });
            if (prompt && prompt.teacherId === user.id) {
                await prisma.savedPrompt.delete({ where: { id } });
                const prompts = await prisma.savedPrompt.findMany({
                    where: { teacherId: user.id },
                    orderBy: { createdAt: 'desc' },
                });
                socket.emit('SAVED_PROMPTS_LIST', prompts);
            }
        } catch (e) {
            console.error('Delete prompt failed', e);
        }
    });

    // --- CLASS MANAGEMENT ---
    socket.on('TEACHER_START_CLASS', async ({ courseId }: { courseId?: string } = {}) => {
        const user = await userPromise;
        if (!user) return;

        if (!courseId) {
            socket.emit('ERROR', { message: 'Course is required to launch a session.' });
            return;
        }

        const course = await prisma.course.findUnique({
            where: { id: courseId },
        });
        if (!course || course.teacherId !== user.id) {
            socket.emit('ERROR', { message: 'You are not authorized to launch this course.' });
            return;
        }

        if (!course.isActive) {
            socket.emit('ERROR', { message: 'Course is not active. Activate it first.' });
            return;
        }

        let session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });

        if (!session) {
            session = await prisma.session.create({
                data: {
                    courseId: course.id,
                    status: 'ACTIVE',
                    maxSwapRequests: 1,
                },
            });
            roomAssignments[course.joinCode] = {};
        } else if (!roomAssignments[course.joinCode]) {
            roomAssignments[course.joinCode] = {};
        }

        const activePrompt = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });

        socket.join(course.joinCode);
        socket.emit('CLASS_STARTED', {
            joinCode: course.joinCode,
            sessionId: session.id,
            maxSwapRequests: session.maxSwapRequests,
        });

        if (activePrompt) {
            broadcastParticipantList(course.joinCode, activePrompt.id);
            const thoughts = await prisma.thought.findMany({
                where: { promptUseId: activePrompt.id },
                include: { author: true },
            });
            const thoughtData = thoughts.map((t) => ({
                id: t.id,
                content: t.content,
                authorName: t.author.name,
            }));
            socket.emit('THOUGHTS_UPDATE', thoughtData);
        } else {
            broadcastParticipantList(course.joinCode, null);
            socket.emit('THOUGHTS_UPDATE', []);
        }

        logEvent('START_CLASS', user.id, {
            courseId: course.id,
            joinCode: course.joinCode,
            sessionId: session.id,
        });
    });

    socket.on('UPDATE_SESSION_SETTINGS', async ({ joinCode, maxSwapRequests }) => {
        const user = await userPromise;
        if (!user) return;
        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;
        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (session) {
            await prisma.session.update({
                where: { id: session.id },
                data: { maxSwapRequests: parseInt(maxSwapRequests) || 1 },
            });
            logEvent('UPDATE_SETTINGS', user.id, { joinCode, maxSwapRequests });
        }
    });

    socket.on('TEACHER_REJOIN', async ({ joinCode }) => {
        const user = await userPromise;
        if (!user) return;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) {
            socket.emit('ERROR', { message: 'Invalid session or unauthorized.' });
            return;
        }

        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (!session) {
            socket.emit('ERROR', { message: 'Session ended.' });
            return;
        }

        socket.join(joinCode);
        socket.emit('CLASS_STARTED', {
            joinCode: course.joinCode,
            sessionId: session.id,
            maxSwapRequests: session.maxSwapRequests,
        });

        const activePrompt = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });

        if (activePrompt) {
            broadcastParticipantList(joinCode, activePrompt.id);
            const thoughts = await prisma.thought.findMany({
                where: { promptUseId: activePrompt.id },
                include: { author: true },
            });
            const thoughtData = thoughts.map((t) => ({
                id: t.id,
                content: t.content,
                authorName: t.author.name,
            }));
            socket.emit('THOUGHTS_UPDATE', thoughtData);
        } else {
            broadcastParticipantList(joinCode, null);
        }
    });

    // Handle teacher resetting for a new prompt
    socket.on('TEACHER_RESET_STATE', async ({ joinCode }) => {
        const user = await userPromise;
        if (!user) return;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;

        // Reset assignments for the next round
        if (roomAssignments[joinCode]) roomAssignments[joinCode] = {};

        // Notify students to go to loading screen
        io.to(joinCode).emit('RESET_CLIENT_STATE');

        // Also clear participants list submission status locally/broadcast it
        broadcastParticipantList(joinCode, null);

        logEvent('RESET_STATE', user.id, { joinCode });
    });

    socket.on('JOIN_ROOM', async ({ joinCode }: { joinCode: string }) => {
        const user = await userPromise;
        if (!user) return;

        const normalizedCode = joinCode.toUpperCase();
        const course = await prisma.course.findUnique({ where: { joinCode: normalizedCode } });

        if (!course) {
            socket.emit('ERROR', { message: 'Invalid Room Code' });
            return;
        }

        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });

        if (!session) {
            socket.emit('ERROR', { message: 'This class session has ended.' });
            return;
        }

        socket.join(normalizedCode);
        socket.emit('JOIN_SUCCESS', { joinCode: normalizedCode, courseTitle: course.title });

        const activePrompt = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });

        if (activePrompt) {
            const existingThought = await prisma.thought.findFirst({
                where: { promptUseId: activePrompt.id, authorId: user.id },
            });

            if (existingThought) {
                if (roomAssignments[normalizedCode] && roomAssignments[normalizedCode][socket.id]) {
                    const assignment = roomAssignments[normalizedCode][socket.id];
                    socket.emit('RECEIVE_SWAP', { content: assignment.content });
                    socket.emit('RESTORE_STATE', {
                        status: 'DISCUSSING',
                        prompt: activePrompt.content,
                        promptUseId: activePrompt.id,
                        type: activePrompt.type,
                        options: activePrompt.options,
                    });
                } else {
                    socket.emit('RESTORE_STATE', {
                        status: 'SUBMITTED',
                        prompt: activePrompt.content,
                        promptUseId: activePrompt.id,
                        type: activePrompt.type,
                        options: activePrompt.options,
                    });
                }
            } else {
                socket.emit('NEW_PROMPT', {
                    content: activePrompt.content,
                    promptUseId: activePrompt.id,
                    type: activePrompt.type,
                    options: activePrompt.options,
                });
            }
        }

        broadcastParticipantList(normalizedCode, activePrompt ? activePrompt.id : null);
        logEvent('JOIN_ROOM', user.id, { joinCode: normalizedCode });
    });

    socket.on('TEACHER_SEND_PROMPT', async (data) => {
        const user = await userPromise;
        if (!user) return;

        const { joinCode, content, type = 'TEXT', options = [] } = data;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;

        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (!session) return;

        const promptUse = await prisma.promptUse.create({
            data: {
                content,
                sessionId: session.id,
                type,
                options: options || [],
            },
        });

        roomAssignments[joinCode] = {};

        io.to(joinCode).emit('NEW_PROMPT', {
            content,
            promptUseId: promptUse.id,
            type,
            options,
        });

        broadcastParticipantList(joinCode, promptUse.id);
        socket.emit('THOUGHTS_UPDATE', []);
        logEvent('SEND_PROMPT', user.id, { joinCode, promptUseId: promptUse.id, content, type });
    });

    socket.on('SUBMIT_THOUGHT', async (data) => {
        const user = await userPromise;
        if (!user) return;
        const { joinCode, content, promptUseId } = data;

        if (promptUseId) {
            await prisma.thought.create({
                data: {
                    content, // For MC/Scale this will be "Option A" or "5"
                    authorId: user.id,
                    promptUseId: promptUseId,
                },
            });

            broadcastParticipantList(joinCode, promptUseId);
            broadcastThoughtsList(joinCode, promptUseId);

            logEvent('SUBMIT_THOUGHT', user.id, { joinCode, promptUseId });
        }
    });

    socket.on('TEACHER_DELETE_THOUGHT', async ({ joinCode, thoughtId }) => {
        const user = await userPromise;
        if (!user) return;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;

        try {
            const thought = await prisma.thought.findUnique({
                where: { id: thoughtId },
                include: { promptUse: true },
            });
            if (thought) {
                const sockets = await io.in(joinCode).fetchSockets();
                const authorSocket = sockets.find((s) => s.data.userId === thought.authorId);
                await prisma.thought.delete({ where: { id: thoughtId } });

                broadcastThoughtsList(joinCode, thought.promptUseId);
                broadcastParticipantList(joinCode, thought.promptUseId);

                if (authorSocket) {
                    authorSocket.emit('THOUGHT_DELETED', {
                        message:
                            'Your response was removed by the facilitator. Please submit a new one.',
                    });
                }

                logEvent('DELETE_THOUGHT', user.id, { thoughtId, content: thought.content });
            }
        } catch (e) {
            console.error('Delete failed', e);
        }
    });

    socket.on('TRIGGER_SWAP', async ({ joinCode }) => {
        const user = await userPromise;
        if (!user) return;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;

        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (!session) return;

        const promptUse = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });
        if (!promptUse) {
            socket.emit('ERROR', { message: 'No active prompt found to swap.' });
            return;
        }

        const thoughts = await prisma.thought.findMany({
            where: { promptUseId: promptUse.id },
            include: { author: true },
        });

        const sockets = await io.in(joinCode).fetchSockets();
        const studentSockets = sockets.filter((s) => s.data.userId !== course.teacherId); // All non-teachers

        if (thoughts.length === 0) {
            socket.emit('ERROR', { message: 'No thoughts submitted yet!' });
            return;
        }

        const thoughtsForShuffle = thoughts.map((t) => ({
            content: t.content,
            authorId: t.authorId,
            authorName: t.author.name,
        }));

        const recipientIds = studentSockets.map((s) => s.id);
        const assignments = shuffleThoughts(thoughtsForShuffle, recipientIds);

        studentSockets.forEach((s) => {
            const assignedData = assignments[s.id];
            if (assignedData) {
                if (!roomAssignments[joinCode]) roomAssignments[joinCode] = {};
                roomAssignments[joinCode][s.id] = {
                    studentName: s.handshake.auth.name || 'Anonymous',
                    thoughtContent: assignedData.content,
                    originalAuthorName: assignedData.originalAuthorName,
                };
                io.to(s.id).emit('RECEIVE_SWAP', { content: assignedData.content });
            }
        });

        const teacherSockets = sockets.filter((s) => s.data.userId === course.teacherId);
        teacherSockets.forEach((t) => {
            t.emit('DISTRIBUTION_UPDATE', roomAssignments[joinCode]);
        });

        socket.emit('SWAP_COMPLETED', { count: Object.keys(assignments).length });
        logEvent('TRIGGER_SWAP', user.id, { joinCode, count: Object.keys(assignments).length });
    });

    socket.on('TEACHER_REASSIGN_DISTRIBUTION', async ({ joinCode, studentSocketId }) => {
        const user = await userPromise;
        if (!user) return;

        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;
        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (!session) return;

        // Ensure assignments exist
        if (!roomAssignments[joinCode] || !roomAssignments[joinCode][studentSocketId]) return;

        const targetStudentAssignment = roomAssignments[joinCode][studentSocketId];

        // Find a new random thought for this student
        // We need the promptUseId to find thoughts
        // We can find promptUseId from the session's active prompt
        const promptUse = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });

        if (!promptUse) return;

        // Get actual student user ID from socket if possible, or we just rely on socket ID for distribution map
        // To be safe, we need the student's User ID to avoid giving them their own thought.
        // We can get it if we stored it in roomAssignments or fetch via socket if connected.
        const sockets = await io.in(joinCode).fetchSockets();
        const targetSocket = sockets.find((s) => s.id === studentSocketId);

        if (!targetSocket) return; // Student disconnected

        const studentUserId = targetSocket.data.userId;

        const allThoughts = await prisma.thought.findMany({
            where: {
                promptUseId: promptUse.id,
                authorId: { not: studentUserId }, // Don't give own thought
            },
            include: { author: true },
        });

        // Filter out the CURRENT assignment if possible to ensure a change, unless it's the only one
        const available = allThoughts.filter(
            (t) => t.content !== targetStudentAssignment.thoughtContent
        );

        // If only 1 other thought exists (swapping pair), we might just swap back to same if we strictly filter.
        // If available is empty, fallback to allThoughts (meaning they might get same one if limited pool)
        const pool = available.length > 0 ? available : allThoughts;

        if (pool.length > 0) {
            const randomThought = pool[Math.floor(Math.random() * pool.length)];

            // Update Assignment
            roomAssignments[joinCode][studentSocketId] = {
                studentName: targetStudentAssignment.studentName,
                thoughtContent: randomThought?.content,
                originalAuthorName: randomThought?.author.name,
            };

            // Notify Student
            io.to(studentSocketId).emit('RECEIVE_SWAP', { content: randomThought?.content });

            // Notify Teacher (Update Graph)
            const teacherSockets = sockets.filter((s) => s.data.userId === course.teacherId);
            teacherSockets.forEach((t) => {
                t.emit('DISTRIBUTION_UPDATE', roomAssignments[joinCode]);
            });

            logEvent('TEACHER_REASSIGN', user.id, { joinCode, targetSocketId: studentSocketId });
        }
    });

    socket.on('STUDENT_REQUEST_NEW_THOUGHT', async ({ joinCode, currentThoughtContent }) => {
        const user = await userPromise;
        if (!user) return;
        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course) return;
        const session = await prisma.session.findFirst({
            where: { courseId: course.id, status: 'ACTIVE' },
        });
        if (!session) return;
        const promptUse = await prisma.promptUse.findFirst({
            where: { sessionId: session.id },
            orderBy: { id: 'desc' },
        });
        if (!promptUse) return;

        const requestsCount = await prisma.swapRequest.count({
            where: { studentId: user.id, sessionId: session.id },
        });

        if (requestsCount >= session.maxSwapRequests) {
            socket.emit('ERROR', {
                message: `Limit reached. You can only request a change ${session.maxSwapRequests} time(s).`,
            });
            return;
        }

        const allThoughts = await prisma.thought.findMany({
            where: { promptUseId: promptUse.id, authorId: { not: user.id } },
            include: { author: true },
        });

        const available = allThoughts.filter((t) => t.content !== currentThoughtContent);

        if (available.length > 0) {
            const randomThought = available[Math.floor(Math.random() * available.length)];
            await prisma.swapRequest.create({
                data: { studentId: user.id, sessionId: session.id },
            });

            if (roomAssignments[joinCode] && roomAssignments[joinCode][socket.id]) {
                roomAssignments[joinCode][socket.id] = {
                    studentName: socket.data.userName || 'Anonymous',
                    thoughtContent: randomThought!.content,
                    originalAuthorName: randomThought!.author.name,
                };
                const sockets = await io.in(joinCode).fetchSockets();
                const teacherSockets = sockets.filter((s) => s.data.userId === course.teacherId);
                teacherSockets.forEach((t) => {
                    t.emit('DISTRIBUTION_UPDATE', roomAssignments[joinCode]);
                });
            }

            socket.emit('RECEIVE_SWAP', { content: randomThought!.content });
            logEvent('REQUEST_RESWAP', user.id, { joinCode });
        } else {
            socket.emit('ERROR', { message: 'No other different thoughts available to swap.' });
        }
    });

    socket.on('END_SESSION', async ({ joinCode }) => {
        const user = await userPromise;
        if (!user) return;
        const course = await prisma.course.findUnique({ where: { joinCode } });
        if (!course || course.teacherId !== user.id) return;

        await prisma.session.updateMany({
            where: { courseId: course.id, status: 'ACTIVE' },
            data: { status: 'COMPLETED' },
        });

        const surveyLink = 'https://jmu.qualtrics.com/jfe/form/SV_dummy_survey_id';
        io.to(joinCode).emit('SESSION_ENDED', { surveyLink });
        const sockets = await io.in(joinCode).fetchSockets();
        sockets.forEach((s) => {
            s.leave(joinCode);
        });
        if (roomAssignments[joinCode]) delete roomAssignments[joinCode];
        logEvent('END_SESSION', user.id, { joinCode });
    });

    // --- ADMIN ENDPOINTS ---
    socket.on('ADMIN_JOIN', async () => {
        // In production, verify admin credentials here
        const user = await userPromise;
        // For now, allow any authenticated user to access admin (add proper auth in production)
        socket.join('admin_room');
        logEvent('ADMIN_JOIN', user?.id || null, {});
    });

    socket.on('ADMIN_GET_DATA', async () => {
        const user = await userPromise;
        // Allow admin access (in production, verify role/permissions)

        try {
            // Get all active sessions
            const activeSessions = await prisma.session.findMany({
                where: { status: 'ACTIVE' },
                include: {
                    course: true,
                    prompts: {
                        include: {
                            thoughts: {
                                include: {
                                    author: true,
                                },
                            },
                        },
                    },
                },
            });

            // Build response with only consented data
            const sessions = activeSessions.map((session) => ({
                id: session.id,
                courseId: session.courseId,
                course: session.course,
                status: session.status,
                maxSwapRequests: session.maxSwapRequests,
                promptCount: session.prompts.length,
            }));

            // Get all thoughts, filtered by consent
            const allThoughts = await prisma.thought.findMany({
                include: {
                    author: true,
                    promptUse: {
                        include: {
                            session: {
                                include: {
                                    course: true,
                                },
                            },
                        },
                    },
                },
            });

            // Filter by consent
            const consentedThoughts = allThoughts
                .filter((thought) => thought.author.consentGiven)
                .map((thought) => ({
                    id: thought.id,
                    content: thought.content,
                    authorName: thought.author.name,
                    authorId: thought.author.id,
                    promptContent: thought.promptUse.session.course.title,
                    createdAt: thought.promptUse.session.course.title, // Use course as timestamp proxy
                    consent: thought.author.consentGiven,
                }));

            // Get swap requests filtered by consent
            const allSwaps = await prisma.swapRequest.findMany({
                include: {
                    student: true,
                    session: {
                        include: {
                            course: true,
                        },
                    },
                },
            });

            const consentedSwaps = allSwaps
                .filter((swap) => swap.student.consentGiven)
                .map((swap) => ({
                    id: swap.id,
                    studentName: swap.student.name,
                    studentId: swap.student.id,
                    classroom: swap.session.course.title,
                    createdAt: swap.createdAt,
                    consent: swap.student.consentGiven,
                }));

            // Get logs filtered by consented users
            const allLogs = await prisma.log.findMany({
                orderBy: { createdAt: 'desc' },
                take: 500,
            });

            const consentedLogs = allLogs.filter((log) => {
                if (!log.userId) return false;
                // In a real scenario, you'd check user consent here
                return true; // Simplified for now
            });

            // Count statistics
            const totalUsers = await prisma.user.findMany();
            const consentedUsers = totalUsers.filter((u) => u.consentGiven);
            const activeUsers = (await io.fetchSockets()).length;

            const adminData = {
                sessions,
                thoughts: consentedThoughts,
                swaps: consentedSwaps,
                logs: consentedLogs,
                stats: {
                    totalConsented: consentedUsers.length,
                    totalUsers: totalUsers.length,
                    activeUsers,
                    activeSessions: activeSessions.length,
                    totalThoughts: consentedThoughts.length,
                    totalSwaps: consentedSwaps.length,
                },
            };

            socket.emit('ADMIN_DATA_UPDATE', adminData);
            logEvent('ADMIN_GET_DATA', user?.id || null, {});
        } catch (e) {
            console.error('Admin data fetch failed', e);
            socket.emit('ERROR', { message: 'Failed to fetch admin data' });
        }
    });

    socket.on('GET_PREVIOUS_SESSIONS', async () => {
        const user = await userPromise;
        if (!user) return;

        try {
            const previousSessions = await prisma.session.findMany({
                where: {
                    course: {
                        teacherId: user.id,
                    },
                    status: 'COMPLETED',
                },
                include: {
                    course: true,
                    prompts: true,
                    _count: {
                        select: { swapRequests: true },
                    },
                },
                orderBy: { id: 'desc' },
            });

            const sessionData = previousSessions.map((session) => ({
                id: session.id,
                joinCode: session.course.joinCode,
                title: session.course.title,
                status: session.status,
                promptCount: session.prompts.length,
                swapCount: session._count.swapRequests,
            }));

            socket.emit('PREVIOUS_SESSIONS', sessionData);
        } catch (e) {
            console.error('Failed to fetch previous sessions:', e);
        }
    });

    socket.on('disconnect', async () => {
        const user = await userPromise;
        if (!user) return;

        // Grace period prevents session teardown during fast page refresh/reconnect.
        setTimeout(async () => {
            try {
                const sockets = await io.fetchSockets();
                const stillConnected = sockets.some((s) => s.data.userId === user.id);
                if (stillConnected) return;

                const activeSessions = await prisma.session.findMany({
                    where: {
                        status: 'ACTIVE',
                        course: {
                            teacherId: user.id,
                        },
                    },
                    include: { course: true },
                });

                for (const session of activeSessions) {
                    await prisma.session.update({
                        where: { id: session.id },
                        data: { status: 'COMPLETED' },
                    });

                    io.to(session.course.joinCode).emit('SESSION_ENDED', {
                        surveyLink: 'https://jmu.qualtrics.com/jfe/form/SV_dummy_survey_id',
                    });

                    const roomSockets = await io.in(session.course.joinCode).fetchSockets();
                    roomSockets.forEach((s) => s.leave(session.course.joinCode));

                    if (roomAssignments[session.course.joinCode]) {
                        delete roomAssignments[session.course.joinCode];
                    }

                    logEvent('SESSION_AUTO_ENDED', user.id, {
                        sessionId: session.id,
                        joinCode: session.course.joinCode,
                    });
                }
            } catch (e) {
                console.error('Auto end on disconnect failed', e);
            }
        }, 6000);
    });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`Server running on ${FRONTEND_URL}:${PORT}`);
});
