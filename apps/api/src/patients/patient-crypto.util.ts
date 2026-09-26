// decryptPatient vive ahora en el módulo único de cifrado (common/crypto/clinical-crypto.ts),
// junto al resto de helpers por modelo. Se reexporta aquí para no romper los imports existentes.
export { decryptPatient } from '../common/crypto/clinical-crypto';
