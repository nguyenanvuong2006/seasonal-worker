import { ReactNode } from "react";

interface FormHeaderProps {
  icon?: ReactNode;
  badge: string;
  title: string;
  description?: string;
}

export default function FormHeader({
  icon,
  badge,
  title,
  description,
}: FormHeaderProps) {
  return (
    <div className="mb-8">

      <div className="flex items-start gap-4">

        {icon && (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gold-100 text-gold-700 shadow-sm">
            {icon}
          </div>
        )}

        <div>

          <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-hasfarm-700">
            {badge}
          </p>

          <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-900">
            {title}
          </h2>

          {description && (
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">
              {description}
            </p>
          )}

        </div>

      </div>

    </div>
  );
}
