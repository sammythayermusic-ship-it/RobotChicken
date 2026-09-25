"use client";

import { useSearchParams } from "next/navigation";
import PlayClient from "./PlayClient";
import { parsePlayParams } from "./params";

export default function PlayFromUrl() {
  const sp = useSearchParams();
  return <PlayClient params={parsePlayParams((k) => sp.get(k))} />;
}
