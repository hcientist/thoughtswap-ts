/*
 * ThoughtSwap
 * Copyright (C) 2026 ThoughtSwap
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const router = Router();

const REQUIRED_SCOPES = [
    'url:GET|/api/v1/accounts/:account_id/terms',
    'url:GET|/api/v1/accounts/:account_id/terms/:id',
    'url:GET|/api/v1/courses/:course_id/enrollments',
    'url:GET|/api/v1/sections/:section_id/enrollments',
    'url:GET|/api/v1/users/:user_id/enrollments',
    'url:GET|/api/v1/courses/:course_id/sections',
    'url:GET|/api/v1/users/:user_id/profile',
    'url:GET|/api/v1/courses',
].join(' ');

// Configuration Constants from .env
const {
    FRONTEND_URL,
    CANVAS_CLIENT_ID,
    CANVAS_CLIENT_SECRET,
    CANVAS_BASE_URL,
    CANVAS_REDIRECT_URI,
} = process.env;

if (!CANVAS_CLIENT_ID || !CANVAS_CLIENT_SECRET || !CANVAS_BASE_URL) {
    throw new Error('Missing one or more required Canvas OAuth environment variables (CANVAS_CLIENT_ID, CANVAS_CLIENT_SECRET, CANVAS_BASE_URL).');
}

const getRedirectUri = (req: Request): string => {
    if (CANVAS_REDIRECT_URI) {
        return CANVAS_REDIRECT_URI;
    }
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    return `${protocol}://${host}/accounts/canvas/login/callback`;
};

// Type definitions
interface CanvasEnrollment {
    id: number;
    user_id: number;
    course_id: number;
    type: string;
    role: string;
    enrollment_state: string;
}

interface CanvasCourse {
    id: number;
    name?: string;
    original_name?: string;
    course_code?: string;
    created_at?: string;
    enrollment_term_id?: number;
    root_account_id?: number;
}

// Cache for enrollment terms to avoid repeated API calls
const termCache: { [key: number]: string } = {};

const fetchTermName = async (
    rootAccountId: number,
    termId: number,
    accessToken: string
): Promise<string> => {
    // Check cache first
    if (termCache[termId]) {
        return termCache[termId];
    }

    try {
        const termResponse = await axios.get(
            `${CANVAS_BASE_URL}/api/v1/accounts/${rootAccountId}/terms/${termId}`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
            }
        );
        const termName = termResponse.data.name;
        termCache[termId] = termName;
        return termName;
    } catch (error) {
        // Silently handle errors
        return 'Unknown';
    }
};

const fetchUserCourses = async (userId: string, accessToken: string): Promise<CanvasCourse[]> => {
    try {
        const coursesResponse = await axios.get(`${CANVAS_BASE_URL}/api/v1/courses`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return coursesResponse.data || [];
    } catch (error) {
        console.error('Error fetching Canvas courses:', error);
        return [];
    }
};

const fetchUserEnrollments = async (
    userId: string,
    accessToken: string
): Promise<CanvasEnrollment[]> => {
    try {
        const enrollmentsResponse = await axios.get(
            `${CANVAS_BASE_URL}/api/v1/users/${userId}/enrollments`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
            }
        );
        return enrollmentsResponse.data || [];
    } catch (error) {
        console.error('Error fetching Canvas enrollments:', error);
        return [];
    }
};

router.get('/', (req: Request, res: Response) => {
    const state = 'random_state_string';
    const redirectUri = getRedirectUri(req);

    const authUrl =
        `${CANVAS_BASE_URL}/login/oauth2/auth?` +
        `client_id=${CANVAS_CLIENT_ID}&` +
        `response_type=code&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `state=${state}&` +
        `scope=${encodeURIComponent(REQUIRED_SCOPES)}`;

    console.log('Redirecting to Canvas Auth URL:', authUrl);
    res.redirect(authUrl);
});

router.get('/callback', async (req: Request, res: Response) => {
    console.log(req.query);
    const code = req.query.code as string;
    const error = req.query.error as string;

    if (error) {
        console.error('Canvas OAuth Error:', error);
        return res.redirect(`${FRONTEND_URL}/?error=auth_denied`);
    }

    if (!code) {
        console.error('Missing authorization code.');
        return res.redirect(`${FRONTEND_URL}/?error=no_code`);
    }

    try {
        const redirectUri = getRedirectUri(req);

        // Step 1: Exchange the code for the Access Token
        const tokenResponse = await axios.post(
            `${CANVAS_BASE_URL}/login/oauth2/token`,
            {
                grant_type: 'authorization_code',
                client_id: CANVAS_CLIENT_ID,
                client_secret: CANVAS_CLIENT_SECRET,
                redirect_uri: redirectUri,
                code: code,
            },
            {
                headers: { 'Content-Type': 'application/json' },
            }
        );

        const { access_token, refresh_token, user } = tokenResponse.data;

        // Step 2: Get User Profile
        const profileResponse = await axios.get(`${CANVAS_BASE_URL}/api/v1/users/self/profile`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        const canvasProfile = profileResponse.data;
        const userEmail = canvasProfile.primary_email;

        if (!user || !userEmail) {
            throw new Error('Missing primary email or user ID from Canvas profile.');
        }

        // Step 3: Upsert User into PostgreSQL (without role field)
        const localUser = await prisma.user.upsert({
            where: { canvasId: String(user.id) },
            update: {
                name: user.name,
                email: userEmail,
                accessToken: access_token,
                refreshToken: refresh_token,
            },
            create: {
                canvasId: String(user.id),
                name: user.name,
                email: userEmail,
                accessToken: access_token,
                refreshToken: refresh_token,
            },
        });

        // Step 4: Fetch user enrollments and courses to sync enrollments
        const enrollments = await fetchUserEnrollments(String(user.id), access_token);
        const courses = await fetchUserCourses(String(user.id), access_token);

        // Step 5: Sync enrollments - create or update Course records and link them
        for (const course of courses) {
            const courseTitle = course.name || course.original_name || course.course_code;

            // Skip courses that don't have any recognizable name (often restricted or inaccessible courses)
            if (!courseTitle) {
                continue;
            }

            // Determine if user is a teacher in this course
            const studentEnrollments = enrollments.filter(
                (e: CanvasEnrollment) => e.course_id === course.id && e.type === 'StudentEnrollment'
            );
            const teacherEnrollments = enrollments.filter(
                (e: CanvasEnrollment) => e.course_id === course.id && e.type === 'TeacherEnrollment'
            );

            // Check both the global enrollments list and the course's own enrollments list
            const courseEnrollments = (course as any).enrollments || [];
            const isTeacherInCourse = courseEnrollments.some(
                (e: any) =>
                    e.type === 'teacher' ||
                    e.role === 'TeacherEnrollment' ||
                    e.type === 'TeacherEnrollment'
            );

            const isTeacher = teacherEnrollments.length > 0 || isTeacherInCourse;
            console.log(
                `Course ${courseTitle} (ID: ${course.id}) - isTeacher: ${isTeacher} - teacher enrollments len: ${teacherEnrollments.length} total user enrollments len: ${enrollments.length}`
            );

            let semester = 'Unknown';
            if (course.enrollment_term_id && course.root_account_id) {
                try {
                    semester = await fetchTermName(
                        course.root_account_id,
                        course.enrollment_term_id,
                        access_token
                    );
                } catch (error) {
                    // Silently handle errors, semester remains 'Unknown'
                }
            }

            // Upsert course (linked by Canvas course ID)
            const courseRecord = await prisma.course.upsert({
                where: { canvasId: String(course.id) },
                update: {
                    title: String(courseTitle),
                    semester,
                },
                create: {
                    canvasId: String(course.id),
                    title: String(courseTitle),
                    semester,
                    joinCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
                    ...(isTeacher ? { teacherId: localUser.id } : {}),
                },
            });

            // Add user to appropriate enrollment lists
            const isStudentInCourse = courseEnrollments.some(
                (e: any) =>
                    e.type === 'student' ||
                    e.role === 'StudentEnrollment' ||
                    e.type === 'StudentEnrollment' ||
                    e.type === 'ta' ||
                    e.role === 'TaEnrollment'
            );

            if (isTeacher) {
                // If user is a teacher, update course teacher (only one teacher per course model)
                await prisma.course.update({
                    where: { id: courseRecord.id },
                    data: { teacherId: localUser.id },
                });
            } else if (studentEnrollments.length > 0 || isStudentInCourse) {
                // Add to students list
                await prisma.course.update({
                    where: { id: courseRecord.id },
                    data: {
                        students: {
                            connect: { id: localUser.id },
                        },
                    },
                });
            }
        }

        // Final Redirect back to the frontend
        const frontendRedirect = `${FRONTEND_URL}/auth/success?name=${encodeURIComponent(localUser.name)}&email=${encodeURIComponent(localUser.email)}`;

        return res.redirect(frontendRedirect);
    } catch (error) {
        console.error('OAuth token exchange failed:', (error as any).message);
        return res.status(500).send('Authentication failed');
    }
});

export { router as authRouter };
