import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
export class RegisterDto {
  @ApiProperty() @IsString() @MinLength(2) firstName!: string;
  @ApiProperty() @IsString() @MinLength(2) lastName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @MinLength(12) password!: string;
  @ApiProperty() @IsString() @MinLength(2) workspaceName!: string;
}
