// Small presentational pieces shared between the read page (both card families) and the saved
// NTAG dump viewer under "Other" — kept together here since neither is big enough to warrant its
// own file, but both need to be imported from more than one place.

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t px-3 py-2 text-sm first:border-t-0">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  );
}

export function formatUid(uid: string): string {
  return uid.match(/.{1,2}/g)?.join(":") ?? uid;
}
