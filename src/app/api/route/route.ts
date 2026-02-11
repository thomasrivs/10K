import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { generateRoute } from "@/lib/route-generator";

const FREE_ROUTE_LIMIT = 5;
const RATE_LIMIT_SECONDS = 30;
const MAX_BODY_SIZE = 1024; // 1 KB

async function getSupabaseClient(request: NextRequest) {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  return { supabase, response };
}

export async function POST(request: NextRequest) {
  try {
    // Validate body size
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Corps de requête trop volumineux" },
        { status: 413 }
      );
    }

    const { supabase } = await getSupabaseClient(request);

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    // Rate limiting: check last route created_at
    const { data: lastRoute } = await supabase
      .from("routes")
      .select("created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastRoute?.created_at) {
      const lastCreated = new Date(lastRoute.created_at).getTime();
      const now = Date.now();
      const secondsSinceLast = (now - lastCreated) / 1000;

      if (secondsSinceLast < RATE_LIMIT_SECONDS) {
        const retryAfter = Math.ceil(RATE_LIMIT_SECONDS - secondsSinceLast);
        return NextResponse.json(
          {
            error: "rate_limited",
            message: `Veuillez attendre ${retryAfter}s avant de générer un nouveau parcours.`,
            retry_after: retryAfter,
          },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfter) },
          }
        );
      }
    }

    // Check quota
    const { count, error: countError } = await supabase
      .from("routes")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      console.error("Count error:", countError);
      return NextResponse.json(
        { error: "Erreur lors de la vérification du quota" },
        { status: 500 }
      );
    }

    const routeCount = count ?? 0;

    if (routeCount >= FREE_ROUTE_LIMIT) {
      return NextResponse.json(
        {
          error: "limit_reached",
          message: "Vous avez atteint la limite de 5 parcours gratuits.",
          count: routeCount,
          limit: FREE_ROUTE_LIMIT,
        },
        { status: 403 }
      );
    }

    // Parse and validate body
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
      return NextResponse.json(
        { error: "JSON invalide" },
        { status: 400 }
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Le body doit être un objet JSON" },
        { status: 400 }
      );
    }

    const { lat, lng } = body as Record<string, unknown>;

    if (typeof lat !== "number" || typeof lng !== "number") {
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

    // Generate route
    const route = await generateRoute(lat, lng);

    // Save to DB (with geometry + duration + status)
    const { data: insertedRoute, error: insertError } = await supabase
      .from("routes")
      .insert({
        user_id: user.id,
        start_lat: lat,
        start_lng: lng,
        distance_m: route.distance,
        steps_estimate: route.stepsEstimate,
        geometry: route.geometry,
        duration_s: route.duration,
        status: "generated",
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
    }

    return NextResponse.json({
      id: insertedRoute?.id ?? null,
      distance_m: route.distance,
      duration_s: route.duration,
      steps_estimate: route.stepsEstimate,
      geometry: route.geometry,
      maneuvers: route.maneuvers,
      routes_used: routeCount + 1,
      routes_limit: FREE_ROUTE_LIMIT,
    });
  } catch (error) {
    console.error("Route generation error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la génération du parcours" },
      { status: 500 }
    );
  }
}
