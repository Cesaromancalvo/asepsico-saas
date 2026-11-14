import { Equals } from 'class-validator';

/** Confirmación explícita del borrado: sin `{ "confirm": true }` exacto, 400 y no se borra nada. */
export class ClearSampleDataDto {
  @Equals(true, { message: 'Confirma el borrado de los datos de ejemplo' })
  confirm!: true;
}
