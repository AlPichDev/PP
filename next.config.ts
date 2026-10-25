import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wails не умеет запускать Node-сервер: фронтенд экспортируется
  // в чистую статику (frontend/out) и встраивается в Go-бинарник.
  // Поэтому здесь ЗАПРЕЩЕНЫ: API Routes, Server Actions, SSR/ISR, getServerSideProps.
  output: "export",
  images: {
    // В статической сборке встроенный оптимизатор картинок недоступен.
    unoptimized: true,
  },
};

export default nextConfig;
