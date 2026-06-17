import { AppRoot } from "@/components/app-root";

// Standalone home route. AppRoot parses URL params once on the client, wires
// theme/session bootstrap, and switches between the connect panel and the
// editor based on store state. Full chrome (header + toolbar) is shown here.
export default function HomePage() {
  return <AppRoot embed={false} />;
}
