/**
 * NotFound.tsx
 *
 * Rendered by the catch-all route in `App.tsx` when no other route matches.
 * Before this page existed, an unknown URL matched nothing and React Router
 * rendered an empty outlet: the navigation stayed visible but the content area
 * was blank, with no way back except editing the address bar (issue #29).
 *
 * The page is deliberately static — it reads no wallet, API, or chain state —
 * so a mistyped or stale link always resolves to something useful, even when
 * the backend is unreachable.
 */

import { Link } from "react-router-dom";
import Layout from "../components/Layout";

export default function NotFound() {
  return (
    <Layout>
      <h1>Page not found</h1>
      <p>The page you requested does not exist or has been moved.</p>
      <p>
        <Link to="/">Back to Dashboard</Link>
      </p>
    </Layout>
  );
}
