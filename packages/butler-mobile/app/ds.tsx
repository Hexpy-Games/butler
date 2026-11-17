import { Redirect, router, useLocalSearchParams } from "expo-router";

// Release bundles fold __DEV__ to false, so the gallery module is never bundled.
const Gallery = __DEV__
  ? (require("../src/ds/gallery/Gallery") as typeof import("../src/ds/gallery/Gallery")).Gallery
  : null;

export default function DsRoute() {
  const { section, state } = useLocalSearchParams<{ section?: string; state?: string }>();
  if (!Gallery) return <Redirect href="/" />;
  return <Gallery section={section} state={state} onSelect={(id) => router.push({ pathname: "/ds", params: { section: id } })} />;
}
