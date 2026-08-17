"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Modal,
  PageHeader,
  SkeletonTable,
  toast,
} from "@/components/ui";
import { ChevronDown, ChevronRight, FolderTree, Move, Pencil, Plus, Power, RefreshCw } from "lucide-react";

type Unit = {
  id: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  legacyDepartmentId: string | null;
};

type Detail = {
  unit: Unit;
  breadcrumb: { id: string; name: string }[];
  childCount: number;
  descendantCount: number;
  activeWorkers: number;
  activeRequests: number;
  todayApplications: number;
};

const UNIT_TYPES = ["COMPANY", "LOCATION", "DIVISION", "DEPARTMENT", "SECTION", "GROUP", "TEAM", "UNIT", "AREA", "FARM", "FACTORY", "LINE", "OTHER"];

function isDescendantPathOf(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath}.`);
}

function TreeRow({
  unit,
  units,
  depth,
  expanded,
  onToggle,
  selectedId,
  onSelect,
}: {
  unit: Unit;
  units: Unit[];
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const children = useMemo(() => units.filter((u) => u.parentId === unit.id).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [units, unit.id]);
  const isOpen = expanded.has(unit.id);
  const isSelected = selectedId === unit.id;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(unit.id)}
        className={`flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] hover:bg-botanical-50 ${isSelected ? "bg-primary-tint font-semibold text-primary" : "text-fg"} ${unit.isActive ? "" : "opacity-50"}`}
        style={{ paddingLeft: `${depth * 18 + 8}px` }}
      >
        {children.length > 0 ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(unit.id);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-muted"
          >
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">{unit.name}</span>
        {!unit.isActive ? (
          <Badge tone="gray" className="ml-1 shrink-0">
            Đã vô hiệu hoá
          </Badge>
        ) : null}
      </button>
      {isOpen && children.length > 0 ? (
        <div>
          {children.map((c) => (
            <TreeRow key={c.id} unit={c} units={units} depth={depth + 1} expanded={expanded} onToggle={onToggle} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function OrganizationTreePage() {
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/organization-units");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không tải được cây tổ chức.");
        setUnits(null);
        return;
      }
      setUnits(data.units ?? []);
      const root = (data.units ?? []).find((u: Unit) => u.parentId === null);
      if (root) setExpanded((prev) => (prev.size === 0 ? new Set([root.id]) : prev));
    } catch {
      setError("Không kết nối được máy chủ.");
      setUnits(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/organization-units/${id}`);
      const data = await res.json();
      if (res.ok) setDetail(data);
      else toast({ title: data.error ?? "Không tải được chi tiết.", variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const root = useMemo(() => units?.find((u) => u.parentId === null) ?? null, [units]);

  const filteredUnits = useMemo(() => {
    if (!units || !search.trim()) return units;
    const q = search.trim().toLowerCase();
    const matchIds = new Set(units.filter((u) => u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q)).map((u) => u.id));
    // Giữ lại toàn bộ tổ tiên của các node khớp để cây vẫn hiển thị đúng đường dẫn.
    const keep = new Set<string>();
    for (const u of units) {
      if (matchIds.has(u.id)) {
        const segments = u.path.split(".");
        let acc = "";
        for (const seg of segments) {
          acc = acc ? `${acc}.${seg}` : seg;
          const anc = units.find((x) => x.path === acc);
          if (anc) keep.add(anc.id);
        }
      }
    }
    return units.filter((u) => keep.has(u.id));
  }, [units, search]);

  const refreshAll = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Cây tổ chức" description="Độ sâu tuỳ ý — không giới hạn tầng (Location/Division/Department/Section/Group/Team...). Không xoá cứng, chỉ vô hiệu hoá." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card className="flex max-h-[75vh] flex-col overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-border p-3">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm đơn vị..." className="h-9 flex-1" />
            <Button variant="outline" className="h-9 w-9 p-0" onClick={() => void load()} title="Tải lại">
              <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading ? (
              <SkeletonTable rows={8} cols={1} />
            ) : error ? (
              <ErrorState description={error} onRetry={() => void load()} />
            ) : !filteredUnits || filteredUnits.length === 0 ? (
              <EmptyState title="Chưa có đơn vị nào" description="Chạy migration để khởi tạo cây tổ chức." />
            ) : root ? (
              <TreeRow unit={root} units={filteredUnits} depth={0} expanded={expanded} onToggle={toggle} selectedId={selectedId} onSelect={setSelectedId} />
            ) : (
              <EmptyState title="Không tìm thấy node gốc" description="Migration organization_units có thể chưa chạy." />
            )}
          </div>
        </Card>

        <Card className="p-5">
          {!selectedId ? (
            <EmptyState icon={<FolderTree className="h-8 w-8" />} title="Chọn 1 đơn vị bên trái" description="Xem chi tiết, breadcrumb, số lao động/yêu cầu, và các thao tác quản lý." />
          ) : detailLoading || !detail ? (
            <SkeletonTable rows={6} cols={2} />
          ) : (
            <div className="space-y-5">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Đường dẫn đầy đủ</div>
                <div className="text-[13px] text-fg-secondary">{detail.breadcrumb.map((b) => b.name).join(" > ")}</div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[20px] font-bold text-fg">{detail.unit.name}</h2>
                <Badge tone="blue">{detail.unit.unitType}</Badge>
                <Badge tone={detail.unit.isActive ? "green" : "gray"}>{detail.unit.isActive ? "Đang hoạt động" : "Đã vô hiệu hoá"}</Badge>
              </div>
              <div className="text-[12px] text-fg-muted">
                Mã: <code className="font-mono">{detail.unit.code}</code> · Path: <code className="font-mono">{detail.unit.path}</code>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  { label: "Đơn vị con", value: detail.childCount },
                  { label: "Toàn subtree", value: detail.descendantCount },
                  { label: "Lao động ACTIVE", value: detail.activeWorkers },
                  { label: "Yêu cầu đang mở", value: detail.activeRequests },
                  { label: "Đăng ký hôm nay", value: detail.todayApplications },
                ].map((m) => (
                  <div key={m.label} className="rounded-[10px] border border-border bg-surface-2 p-3">
                    <div className="text-[20px] font-bold text-fg">{m.value}</div>
                    <div className="text-[11px] text-fg-muted">{m.label}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> Thêm đơn vị con
                </Button>
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-4 w-4" /> Sửa
                </Button>
                <Button variant="outline" onClick={() => setMoveOpen(true)} disabled={detail.unit.parentId === null}>
                  <Move className="h-4 w-4" /> Di chuyển
                </Button>
                <Button variant={detail.unit.isActive ? "danger" : "outline"} onClick={() => setDeactivateOpen(true)} disabled={detail.unit.parentId === null}>
                  <Power className="h-4 w-4" /> {detail.unit.isActive ? "Vô hiệu hoá" : "Kích hoạt lại"}
                </Button>
              </div>
              {detail.unit.legacyDepartmentId ? (
                <p className="text-[11.5px] text-fg-muted">
                  Đơn vị này được migrate từ bảng Department cũ (legacy) — số liệu lao động/yêu cầu ở trên đọc qua liên kết này.
                </p>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      {addOpen && selectedId && units ? (
        <AddChildModal
          parentId={selectedId}
          onClose={() => setAddOpen(false)}
          onCreated={async (newId) => {
            setAddOpen(false);
            await refreshAll();
            setExpanded((prev) => new Set(prev).add(selectedId));
            setSelectedId(newId);
          }}
        />
      ) : null}

      {editOpen && detail ? (
        <EditModal
          unit={detail.unit}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await refreshAll();
          }}
        />
      ) : null}

      {moveOpen && detail && units ? (
        <MoveModal
          unit={detail.unit}
          units={units}
          onClose={() => setMoveOpen(false)}
          onMoved={async () => {
            setMoveOpen(false);
            await refreshAll();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deactivateOpen}
        onClose={() => setDeactivateOpen(false)}
        title={detail?.unit.isActive ? "Vô hiệu hoá đơn vị?" : "Kích hoạt lại đơn vị?"}
        description={
          detail?.unit.isActive
            ? "Đơn vị và toàn bộ lịch sử (lao động/yêu cầu đã gắn) vẫn được giữ nguyên — chỉ ẩn khỏi các lựa chọn mới."
            : "Đơn vị sẽ hiển thị lại trong danh sách lựa chọn."
        }
        danger={!!detail?.unit.isActive}
        loading={busy}
        confirmLabel={detail?.unit.isActive ? "Vô hiệu hoá" : "Kích hoạt lại"}
        onConfirm={async () => {
          if (!detail) return;
          setBusy(true);
          try {
            const res = await fetch(`/api/organization-units/${detail.unit.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: detail.unit.isActive ? "DEACTIVATE" : "REACTIVATE" }),
            });
            const d = await res.json();
            if (!res.ok) {
              toast({ title: d.error ?? "Thất bại", variant: "destructive" });
              return;
            }
            toast({ title: "✅ Đã cập nhật trạng thái." });
            setDeactivateOpen(false);
            await refreshAll();
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function AddChildModal({ parentId, onClose, onCreated }: { parentId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [unitType, setUnitType] = useState("OTHER");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast({ title: "Nhập tên đơn vị.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/organization-units", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, code: code || undefined, unitType, parentId }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: `✅ Đã thêm "${d.unit.name}".` });
      onCreated(d.unit.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Thêm đơn vị con"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Tạo
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Tên đơn vị</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Chrysanthemums" autoFocus />
        </div>
        <div>
          <Label>Mã (tuỳ chọn — để trống sẽ tự sinh từ tên)</Label>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VD: chry" />
        </div>
        <div>
          <Label>Loại đơn vị</Label>
          <select value={unitType} onChange={(e) => setUnitType(e.target.value)} className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[13px]">
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function EditModal({ unit, onClose, onSaved }: { unit: Unit; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(unit.name);
  const [unitType, setUnitType] = useState(unit.unitType);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/organization-units/${unit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, unitType }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "✅ Đã lưu." });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Sửa đơn vị"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Tên đơn vị</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <Label>Loại đơn vị</Label>
          <select value={unitType} onChange={(e) => setUnitType(e.target.value)} className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[13px]">
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function MoveModal({ unit, units, onClose, onMoved }: { unit: Unit; units: Unit[]; onClose: () => void; onMoved: () => void }) {
  const [search, setSearch] = useState("");
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => {
    return units
      .filter((u) => u.isActive && u.id !== unit.id && !isDescendantPathOf(u.path, unit.path))
      .filter((u) => !search.trim() || u.name.toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [units, unit, search]);

  const submit = async () => {
    if (!newParentId) {
      toast({ title: "Chọn đơn vị cha mới.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/organization-units/${unit.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newParentId }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: `✅ Đã di chuyển "${unit.name}".` });
      onMoved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Di chuyển "${unit.name}"`}
      description="Toàn bộ đơn vị con (nếu có) sẽ đi theo. Không thể chọn chính nó hoặc đơn vị con cháu của nó làm cha mới."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving} disabled={!newParentId}>
            Di chuyển
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm đơn vị cha mới..." />
        <div className="max-h-64 overflow-y-auto rounded-[10px] border border-border">
          {candidates.length === 0 ? (
            <div className="p-3 text-[12.5px] text-fg-muted">Không có đơn vị hợp lệ.</div>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setNewParentId(c.id)}
                className={`block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-botanical-50 ${newParentId === c.id ? "bg-primary-tint font-semibold text-primary" : "text-fg"}`}
                title={c.path}
              >
                {c.path.split(".").length - 1 > 0 ? "— ".repeat(c.path.split(".").length - 1) : ""}
                {c.name}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
