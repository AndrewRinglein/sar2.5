/*
 * Deno entry for the Supabase Edge Function `sar2-api`. NOT imported by Node:
 * `npm run build:edge` bundles this file, everything it imports and the
 * knowledge file into supabase/functions/sar2-api/index.ts, the file that is
 * deployed. Edit the sources, then rebuild; never edit the bundle.
 *
 * Only Deno-specific glue lives here. Behaviour is in edge-api.mjs and
 * api-core.mjs, which the test suite runs under Node.
 */
import pg from 'npm:pg@8';
import knowledge from 'sar2:knowledge';
import { SUPABASE_ROOT_CA } from './supabase-ca.mjs';
import { createEdgeServer } from './edge-api.mjs';

Deno.serve(createEdgeServer({ env: (name) => Deno.env.get(name), pg, knowledge, ca: SUPABASE_ROOT_CA }));
