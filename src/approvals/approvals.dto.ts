import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateExpense {
  @ApiProperty({ example: 'Passagem para visita ao cliente' })
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  description!: string;

  @ApiProperty({ example: 15000, description: 'Valor em centavos de BRL' })
  @IsInt()
  @Min(1)
  @Max(1000000000)
  amountCents!: number;
}

export class VersionCommand {
  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  version!: number;
}
