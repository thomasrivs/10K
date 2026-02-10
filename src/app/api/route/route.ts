import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { generateRoute } from "@/lib/route-generator";

const FREE_ROUTE_LIMIT = 5;

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
    const { supabase } = await getSupabaseClient(request);

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
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

    const { lat, lng } = await request.json();

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
