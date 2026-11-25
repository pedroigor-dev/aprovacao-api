import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { User } from './identity.types';

export class Login {
  @ApiProperty({ example: 'empresa-a' })
  @Matches(/^[a-z0-9-]{2,50}$/)
  tenant!: string;

  @ApiProperty({ example: 'ana@example.com' })
  @IsEmail()
  @MaxLength(180)
  email!: string;

  @ApiProperty({ minLength: 12, example: 'Senha-local-segura-123!' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

export class ProvisionUser extends Login {
  @ApiProperty({ enum: ['requester', 'approver', 'finance', 'auditor'] })
  @IsIn(['requester', 'approver', 'finance', 'auditor'])
  role!: User['role'];
}
