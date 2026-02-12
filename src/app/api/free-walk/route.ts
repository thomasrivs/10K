import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/api-supabase";

const MAX_BODY_SIZE = 256;

export async function POST(request: NextRequest) {
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Corps de requête trop volumineux" },
        { status: 413 }
      );
    }

    const { supabase } = await getSupabaseClient(request);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Corps de requête trop volumineux" },
        { status: 413 }
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Le body doit être un objet JSON" },
        { status: 400 }
      );
    }

    const { lat, lng } = body as Record<string, unknown>;

    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      isNaN(lat) ||
      isNaN(lng)
    ) {
      return NextResponse.json(
        { error: "lat et lng sont requis (nombres)" },
        { status: 400 }
      );
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json(
        { error: "Coordonnées invalides" },
        { status: 400 }
      );
    }

    const { data: insertedRoute, error: insertError } = await supabase
      .from("routes")
      .insert({
        user_id: user.id,
        start_lat: lat,
        start_lng: lng,
        status: "in_progress",
        distance_m: 0,
        steps_estimate: 0,
        duration_s: 0,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return NextResponse.json(
        { error: "Erreur lors de la création du parcours libre" },
        { status: 500 }
      );
    }

    return NextResponse.json({ id: insertedRoute?.id ?? null });
  } catch (error) {
    console.error("Free walk creation error:", error);
    return NextResponse.json(
      { error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
