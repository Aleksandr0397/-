import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Инвентари Атолл — Автозапчасти",
  description: "Поиск запчастей, персональные цены и заказы в кабинете клиента.",
  manifest: "/manifest.webmanifest",
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
