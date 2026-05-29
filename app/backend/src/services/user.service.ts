import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppUser, JwtPayload, UserRole } from '../types/user.types';
import { config } from '../config/env';

// Users seeded from environment variables. Format in .env:
//   APP_USERS=[{"id":"u1","username":"admin","email":"admin@example.com","role":"admin","password":"secret"}]
function loadUsers(): AppUser[] {
  const raw = process.env.APP_USERS;
  if (!raw) {
    return [
      {
        id: 'u_default_admin',
        username: 'admin',
        email: 'admin@alertinsurance.in',
        role: 'admin' as UserRole,
        // bcrypt of "admin123" — change via APP_USERS env before production
        passwordHash: '$2b$10$i6uFVIt49O3PL3APwWkyUuTM/1BHmNOlYX4u6ybAOOOdVpDjcrxG2',
      },
      {
        id: 'u_default_agent',
        username: 'agent',
        email: 'agent@alertinsurance.in',
        role: 'user' as UserRole,
        passwordHash: '$2b$10$i6uFVIt49O3PL3APwWkyUuTM/1BHmNOlYX4u6ybAOOOdVpDjcrxG2',
      },
    ];
  }

  try {
    const parsed = JSON.parse(raw) as Array<Omit<AppUser, 'passwordHash'> & { password: string }>;
    return parsed.map(u => ({
      id:           u.id,
      username:     u.username,
      email:        u.email,
      role:         u.role,
      passwordHash: bcrypt.hashSync(u.password, 10),
    }));
  } catch {
    throw new Error('APP_USERS env var is not valid JSON');
  }
}

const USERS: AppUser[] = loadUsers();

const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

export function findByUsername(username: string): AppUser | undefined {
  return USERS.find(u => u.username === username);
}

export function findById(id: string): AppUser | undefined {
  return USERS.find(u => u.id === id);
}

export async function verifyPassword(user: AppUser, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export function signToken(user: AppUser): string {
  const payload: JwtPayload = {
    sub:      user.id,
    username: user.username,
    email:    user.email,
    role:     user.role,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function listUsers() {
  return USERS.map(({ id, username, email, role }) => ({ id, username, email, role }));
}
