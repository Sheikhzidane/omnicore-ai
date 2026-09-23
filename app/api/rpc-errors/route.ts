import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

interface RpcErrorRecord {
  id: string;
  agent_name: string;
  rpc_name: string;
  error_code: string | null;
  error_message: string | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

/**
 * GET /api/rpc-errors
 * 
 * Fetch resolved RPC errors from the database.
 * Query parameters:
 * - resolved: boolean (default: true)
 * - limit: number (default: 100)
 * - offset: number (default: 0)
 */
export async function GET(request: NextRequest) {
  const authz = await requirePlatformAdminReadApi(request)
  if (!authz.ok) return authz.response

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: 'Missing Supabase credentials' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const resolved = searchParams.get('resolved') !== 'false';
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    // Build query
    let query = supabase
      .from('rpc_error_log')
      .select(
        'id, agent_name, rpc_name, error_code, error_message, resolved, resolved_at, created_at'
      )
      .eq('resolved', resolved);

    // Apply ordering
    if (resolved) {
      query = query.order('resolved_at', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json(
        { error: `Database query failed: ${error.message}` },
        { status: 500 }
      );
    }

    // Return data with pagination info
    return NextResponse.json(
      {
        data: data || [],
        pagination: {
          limit,
          offset,
          total: count || 0,
        },
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('RPC errors API error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
