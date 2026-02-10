"use client";

import dynamic from "next/dynamic";
import AuthGuard from "@/components/AuthGuard";

const Map = dynamic(() => import("@/components/Map"), { ssr: false });

export default function Home() {
  return (
    <AuthGuard>
      {() => (
        <main className="h-dvh w-screen">
          <Map />
        </main>
      )}
    </AuthGuard>
  );
}
