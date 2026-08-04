import { handlers } from "@/auth";

export const { GET, POST } = handlers;

// The adapter and the Nodemailer provider both need Node APIs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
