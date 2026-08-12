import { redirect } from "next/navigation";

/** App entry is sign-in. Marketing / integration docs live on the static site. */
export default function HomePage() {
  redirect("/login");
}
