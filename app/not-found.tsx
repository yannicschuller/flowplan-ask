import Link from "next/link";
import { pageT } from "@/lib/page";

export default async function NotFound() {
  const { t, locale } = await pageT();
  return (
    <div className="card narrow">
      <h1>{t("Nicht gefunden", "Not found")}</h1>
      <p className="muted">{t("Diese Seite gibt es nicht.", "This page doesn't exist.")}</p>
      <Link className="button" href={`/?lang=${locale}`}>
        {t("Zu Flo", "Back to Flo")}
      </Link>
    </div>
  );
}
