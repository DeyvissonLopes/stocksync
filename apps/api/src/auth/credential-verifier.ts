import argon2 from 'argon2';
import type { EntityManager } from 'typeorm';
import { UserEntity, type UserRole } from '../database/entities/user.entity.js';

export type AuthenticatedIdentity = {
  userId: string;
  tenantId: string;
  role: UserRole;
};

export class CredentialVerifier {
  constructor(private readonly manager: EntityManager) {}

  async verify(email: string, password: string): Promise<AuthenticatedIdentity | null> {
    const user = await this.manager.getRepository(UserEntity).findOne({
      where: { email },
      select: { id: true, tenantId: true, role: true, passwordHash: true, isActive: true },
    });
    if (!user?.isActive || !(await argon2.verify(user.passwordHash, password))) {
      return null;
    }

    return { userId: user.id, tenantId: user.tenantId, role: user.role };
  }
}
