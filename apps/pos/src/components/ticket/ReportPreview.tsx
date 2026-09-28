import type { ReportPayload } from '@pos/core';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Aperçu papier d'un rapport X / Z (mêmes sections que l'impression du pont). */
export function ReportPreview({
  report,
  className,
}: {
  report: ReportPayload;
  className?: string;
}) {
  return (
    <article
      data-testid="report-preview"
      data-kind={report.kind}
      className={cn(
        'selectable rounded-xl border border-border bg-white px-5 py-5 font-mono text-[13px] leading-snug text-black shadow-inner',
        className,
      )}
    >
      <header className="text-center">
        <p className="text-base font-bold">{report.header.company_name}</p>
        {report.header.address_lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {report.header.siret && <p>SIRET {report.header.siret}</p>}
        <p className="mt-2 border-y border-dashed border-black/60 py-1 text-base font-bold">
          {report.title}
        </p>
        {report.subtitle && <p>{report.subtitle}</p>}
        {report.training && (
          <p className="mt-1 font-bold" data-testid="report-training">
            *** FORMATION — sans valeur ***
          </p>
        )}
        {report.duplicate && <p className="mt-1 font-bold">*** DUPLICATA ***</p>}
      </header>
      {report.sections.map((section, i) => (
        <section
          key={section.title ?? `s${i}`}
          className="border-b border-dashed border-black/40 py-2"
        >
          {section.title && <p className="font-bold uppercase">{section.title}</p>}
          <dl>
            {section.rows.map((row) => (
              <div
                key={`${row.label}-${row.value ?? ''}`}
                className={cn('flex justify-between gap-3', row.bold && 'font-bold')}
              >
                <dt className="min-w-0">{row.label}</dt>
                {row.value !== undefined && (
                  <dd className="shrink-0 text-right tabular">{row.value}</dd>
                )}
              </div>
            ))}
          </dl>
        </section>
      ))}
      <footer className="pt-2 text-center">
        {report.footer.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p>Édité le {formatDateTime(report.printed_at)}</p>
        <p>
          {report.software} v{report.app_version}
        </p>
      </footer>
    </article>
  );
}
