import "./globals.css";

export const metadata = {
  title: "SQL Form — генератор SQL-запросов",
  description:
    "Десктопное приложение: заполнение SQL-шаблона через форму (PostgreSQL · Electron + Next.js)",
};

export const viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
