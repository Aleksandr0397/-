import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Инвентари Атолл — Автозапчасти",
  description: "Поиск запчастей, персональные цены и заказы в кабинете клиента.",
  appleWebApp: { capable: true, title: "Атолл", statusBarStyle: "default" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/app-icon-192.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
