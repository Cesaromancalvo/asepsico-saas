import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { CreateSessionDto } from '../src/sessions/dto/create-session.dto';

/**
 * El enlace de videollamada se muestra al paciente en el portal y se abre desde la web: solo se
 * aceptan URLs https absolutas (nada de javascript:, data:, http: ni rutas relativas).
 * Datos 100 % ficticios.
 */
const GLOBAL_PIPE_OPTIONS: ValidatorOptions = { whitelist: true, forbidNonWhitelisted: true };

const BASE = {
  patientId: 'patient-ficticio',
  startsAt: '2026-10-05T09:00:00.000Z',
  endsAt: '2026-10-05T09:50:00.000Z',
};

async function videoCallErrors(videoCallUrl: unknown) {
  const dto = plainToInstance(CreateSessionDto, { ...BASE, videoCallUrl });
  const errors = await validate(dto, GLOBAL_PIPE_OPTIONS);
  return errors.filter((error) => error.property === 'videoCallUrl');
}

describe('CreateSessionDto.videoCallUrl', () => {
  it('acepta una URL https absoluta', async () => {
    expect(await videoCallErrors('https://meet.example.test/sala-ficticia')).toHaveLength(0);
  });

  it('sigue siendo opcional', async () => {
    const errors = await validate(plainToInstance(CreateSessionDto, BASE), GLOBAL_PIPE_OPTIONS);
    expect(errors.filter((error) => error.property === 'videoCallUrl')).toHaveLength(0);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://meet.example.test/sala',
    'ftp://example.test/sala',
    '//meet.example.test/sala',
    'meet.example.test/sala',
    '/sala-relativa',
    'no es una url',
  ])('rechaza %s', async (value) => {
    expect((await videoCallErrors(value)).length).toBeGreaterThan(0);
  });
});
