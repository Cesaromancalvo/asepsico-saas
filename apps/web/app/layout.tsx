import './globals.css';
export const metadata = { title: 'AsePsico', description: 'Sistema operativo para la práctica psicológica' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="es"><body>{children}</body></html>; }
