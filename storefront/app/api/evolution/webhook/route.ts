import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log("EVOLUTION WEBHOOK:", JSON.stringify(body).slice(0, 3000));
    return NextResponse.json({ ok: true });
  } catch (e:any) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "webhook alive", instance: process.env.EVOLUTION_INSTANCE });
}
