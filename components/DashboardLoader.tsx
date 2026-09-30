"use client";

import dynamic from "next/dynamic";

// The dashboard reads localStorage and the live clock, so it is rendered on the client only.
const Dashboard = dynamic(() => import("./Dashboard"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted text-sm tracking-widest">
      LOADING SCANNER…
    </div>
  ),
});

export default function DashboardLoader() {
  return <Dashboard />;
}
