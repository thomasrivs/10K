import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

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

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await getSupabaseClient(request);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const { data: routes, error } = await supabase
      .from("routes")
      .select(
        "id, start_lat, start_lng, distance_m, steps_estimate, duration_s, geometry, status, walked_distance_m, walked_duration_s, completed_at, created_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) {
      console.error("History error:", error);
      return NextResponse.json(
        { error: "Erreur lors du chargement de l'historique" },
        { status: 500 }
      );
    }

    return NextResponse.json({ routes: routes ?? [] });
  } catch (error) {
    console.error("History error:", error);
    return NextResponse.json(
      { error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
