/** Один раз (по просьбе владельца): первый баннер главной — Van Cleef Alhambra, обложка — синий Vintage Alhambra (белое золото, халцедон). */
export async function ensureAlhambra(store) {
  try { const AID = "collection.vancleefarpels_com_fr_en_collections_jewelry_alhambra_html"; if (!(await store.get("settings.fixAlhCov1"))) { const at = new Date().toISOString(), prev = await store.get(AID);
      const others = (await store.list("collection", { pinned: true }, { limit: 50, fields: "_id" })).map(x => x._id).filter(x => x !== AID); if (others.length) await store.patchMany(others, { pinned: false });
      const doc = { _id: AID, _type: "collection", section: "vancleefarpels.com/fr/en/collections/jewelry/alhambra.html", url: "https://www.vancleefarpels.com/fr/en/collections/jewelry/alhambra.html", brand: "Van Cleef & Arpels", title: "Alhambra", desc: "", g: "u", kind: "coll", on: true, pinned: true, edited: true, until: "2027-03-01", createdAt: prev?.createdAt || at, lastRun: at, found: prev?.found || 0,
        cover: "https://www.vancleefarpels.com/content/dam/rcq/vca/wf/Ey/TP/yK/Tn/-Q/Px/t4/1c/oI/uw/wfEyTPyKTn-QPxt41coIuw.png" };
      if (prev) await store.patchMany([AID], { on: true, pinned: true, cover: doc.cover, title: "Alhambra", edited: true, until: doc.until }); else await store.put(doc);
      await store.put({ _id: "settings.fixAlhCov1", _type: "settings", at }); }
    // ноябрь 2026, по просьбе владельца: обложка Alhambra — Vintage Alhambra Bracelet, 5 Motifs, жёлтое золото + оникс (vcara41300)
    if (!(await store.get("settings.fixAlhCov2"))) { await store.patchMany([AID], { cover: "https://www.vancleefarpels.com/content/dam/rcq/vca/sd/0M/4g/do/QC/C6/cO/No/rb/Hb/IA/sd0M4gdoQCC6cONorbHbIA.png" });
      await store.put({ _id: "settings.fixAlhCov2", _type: "settings", at: new Date().toISOString() }); } } catch (e) { console.log("ALHCOV " + String(e.message).slice(0, 80)); }
}
