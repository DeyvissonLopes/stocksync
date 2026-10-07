import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import argon2 from 'argon2';
import type { Repository } from 'typeorm';
import { UserEntity, type UserRole } from '../database/entities/user.entity.js';

// Public dummy hash with the same Argon2id parameters as real accounts.
const dummyPasswordHash = '$argon2id$v=19$m=65536,p=4,t=3$c3RvY2tzeW5jLWR1bW15LXNhbHQ$fR3w1DtRo3kVStSUxwSR4lYijUHO03DvB9hK3+QgnCo';

export type AuthenticatedIdentity = {
  userId: string;
  tenantId: string;
  role: UserRole;
};

@Injectable()
export class CredentialVerifier {
  constructor(@InjectRepository(UserEntity) private readonly users: Repository<UserEntity>) {}

  async verify(email: string, password: string): Promise<AuthenticatedIdentity | null> {
    const user = await this.users.findOne({
      where: { email },
      select: { id: true, tenantId: true, role: true, passwordHash: true, isActive: true },
    });
    const hash = user?.isActive ? user.passwordHash : dummyPasswordHash;
    const passwordMatches = await argon2.verify(hash, password);
    if (!user?.isActive || !passwordMatches) {
      return null;
    }

    return { userId: user.id, tenantId: user.tenantId, role: user.role };
  }
}
