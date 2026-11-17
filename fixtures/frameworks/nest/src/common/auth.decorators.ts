import { SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';

/** Routes anyone may call: the global AuthGuard lets them through without a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Roles a caller needs (checked by RolesGuard). */
export const Roles = Reflector.createDecorator<string[]>();
