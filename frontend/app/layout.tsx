import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cartelera.ar - Cartelera de Cine Argentina",
  description: "Cartelera de cine en Argentina - Datos de La Nacion",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="bg-background">
      <body className="antialiased min-h-screen">
        {children}
        <Toaster 
          position="bottom-right" 
          theme="dark"
          toastOptions={{
            style: {
              background: "#18181b",
              border: "1px solid #27272a",
              color: "#e4e4e7",
            },
          }}
        />
      </body>
    </html>
  );
}
