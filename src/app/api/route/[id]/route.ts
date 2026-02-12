import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/api-supabase";

const MAX_BODY_SIZE = 512_000; // 512 KB (geometry can be large)
const ALLOWED_FIELDS = new Set([
  "status",
  "walked_distance_m",
  "walked_duration_s",
  "geometry",
  "distance_m",
  "steps_estimate",
  "duration_s",
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return NextResponse.json(
        { error: "Identifiant de parcours invalide" },
        { status: 400 }
      );
    }

    // Validate body size
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

    // Parse and validate body
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Corps de requête trop volumineux" },
        { status: 413 }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "JSON invalide" },
        { status: 400 }
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "Le body doit être un objet JSON" },
        { status: 400 }
      );
    }

    const body = parsed as Record<string, unknown>;

    // Only allow known fields
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return NextResponse.json(
        { error: `Champs non autorisés : ${unknownFields.join(", ")}` },
        { status: 400 }
      );
    }

    const { status, walked_distance_m, walked_duration_s, geometry, distance_m, steps_estimate, duration_s } = body;

    const validStatuses = ["in_progress", "completed", "abandoned"];
    if (status && !validStatuses.includes(status as string)) {
      return NextResponse.json(
        { error: "Statut invalide" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (typeof walked_distance_m === "number") {
      if (walked_distance_m < 0 || isNaN(walked_distance_m)) {
        return NextResponse.json(
          { error: "walked_distance_m doit être un nombre positif" },
          { status: 400 }
        );
      }
      updateData.walked_distance_m = Math.round(walked_distance_m);
    }
    if (typeof walked_duration_s === "number") {
      if (walked_duration_s < 0 || isNaN(walked_duration_s)) {
        return NextResponse.json(
          { error: "walked_duration_s doit être un nombre positif" },
          { status: 400 }
        );
      }
      updateData.walked_duration_s = Math.round(walked_duration_s);
    }
    // Validate geometry (GeoJSON LineString)
    if (geometry !== undefined) {
      if (
        typeof geometry !== "object" ||
        geometry === null ||
        (geometry as Record<string, unknown>).type !== "LineString" ||
        !Array.isArray((geometry as Record<string, unknown>).coordinates)
      ) {
        return NextResponse.json(
          { error: "geometry doit être un GeoJSON LineString valide" },
          { status: 400 }
        );
      }
      updateData.geometry = geometry;
    }

    if (typeof distance_m === "number") {
      if (distance_m < 0 || isNaN(distance_m)) {
        return NextResponse.json(
          { error: "distance_m doit être un nombre positif" },
          { status: 400 }
        );
      }
      updateData.distance_m = Math.round(distance_m);
    }

    if (typeof steps_estimate === "number") {
      if (steps_estimate < 0 || isNaN(steps_estimate)) {
        return NextResponse.json(
          { error: "steps_estimate doit être un nombre positif" },
          { status: 400 }
        );
      }
      updateData.steps_estimate = Math.round(steps_estimate);
    }

    if (typeof duration_s === "number") {
      if (duration_s < 0 || isNaN(duration_s)) {
        return NextResponse.json(
          { error: "duration_s doit être un nombre positif" },
          { status: 400 }
        );
      }
      updateData.duration_s = Math.round(duration_s);
    }

    if (status === "completed") updateData.completed_at = new Date().toISOString();

    const { error } = await supabase
      .from("routes")
      .update(updateData)
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      console.error("Update error:", error);
      return NextResponse.json(
        { error: "Erreur lors de la mise à jour" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Route update error:", error);
    return NextResponse.json(
      { error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
