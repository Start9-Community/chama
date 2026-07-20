self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const escrowId = event.notification.data && event.notification.data.escrowId;
  const target = escrowId ? `/?trade=${encodeURIComponent(escrowId)}` : "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
