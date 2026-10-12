import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ConfirmImportDto, PreviewImportDto, TemplateQueryDto, UploadQueryDto } from './dto/patient-import.dto';
import { IMPORT_LIMITS } from './import-limits';
import { PatientImportConfirmService } from './patient-import-confirm.service';
import { PatientImportRevertService } from './patient-import-revert.service';
import { PatientImportService, UploadedFile as ImportUpload } from './patient-import.service';

// El fichero se queda en memoria (nunca en disco) y multer corta la subida al pasar de 5 MB,
// antes de que llegue al servicio.
const UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: IMPORT_LIMITS.MAX_FILE_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 1024 },
};

const download = (res: Response, file: { buffer: Buffer; contentType: string; fileName: string }) => {
  res.set({
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.fileName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return new StreamableFile(file.buffer);
};

/**
 * Importación de pacientes (docs/producto/importacion-pacientes-csv.md). Todas las rutas:
 * sesión de staff, CSRF en las escrituras y rol clínico (ver PatientImportAccess).
 */
@ApiTags('patient-imports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('patient-imports')
export class PatientImportController {
  constructor(
    private readonly imports: PatientImportService,
    private readonly confirmService: PatientImportConfirmService,
    private readonly revertService: PatientImportRevertService,
  ) {}

  @Get('template')
  async template(@CurrentUser() user: AuthUser, @Query() query: TemplateQueryDto, @Res({ passthrough: true }) res: Response) {
    return download(res, await this.imports.template(user, query.format));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: ImportUpload | undefined, @Query() query: UploadQueryDto) {
    return this.imports.upload(user.workspaceId, user, file, query.sheet ?? 0);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.imports.list(user.workspaceId, user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.imports.get(user.workspaceId, user, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/preview')
  @HttpCode(200)
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PreviewImportDto) {
    return this.imports.preview(user.workspaceId, user, id, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ConfirmImportDto) {
    return this.confirmService.confirm(user.workspaceId, user, id, dto.decisions ?? []);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.imports.cancel(user.workspaceId, user, id);
  }

  @Get(':id/error-report')
  async errorReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return download(res, await this.imports.errorReport(user.workspaceId, user, id));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/revert')
  @HttpCode(200)
  revert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.revertService.revert(user.workspaceId, user, id);
  }
}
