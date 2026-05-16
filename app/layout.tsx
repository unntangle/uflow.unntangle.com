import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--crm-font',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export const metadata: Metadata = {
  title: {
    template: '%s | uFLOW',
    default: 'uFLOW',
  },
  description: 'Internal project management for 3D artists and QA reviewers.',
  icons: {
    icon: [
      { url: '/uflow/uFLOW-fav-icon.webp', type: 'image/webp' },
    ],
    shortcut: '/uflow/uFLOW-fav-icon.webp',
    apple: '/uflow/uFLOW-fav-icon.webp',
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  openGraph: { title: 'uFLOW', images: [] },
  twitter: { title: 'uFLOW', images: [] },
  alternates: { canonical: undefined },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`crm-root ${plusJakarta.variable}`}>
        {children}
      </body>
    </html>
  );
}
