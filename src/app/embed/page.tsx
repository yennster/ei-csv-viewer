import { AppRoot } from "@/components/app-root";

// Embedded route for the Studio extension iframe. Same editor, app header
// chrome stripped (embed=true). The `ei_session` cookie is sameSite:"none" so
// /api/ei/* calls carry the session inside the Studio frame, and URL params are
// merged from the parent frame by parseCurrentParams().
export default function EmbedPage() {
  return <AppRoot embed />;
}
