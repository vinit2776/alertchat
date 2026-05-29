export type UserRole = 'user' | 'admin';

export interface AppUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  passwordHash: string;
}

export interface JwtPayload {
  sub: string;       // user id
  username: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}
