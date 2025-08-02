import InfoTooltip from "~/components/InfoTooltip";

export const FormHeader: React.FC<{ title: string; subtitle: string; tooltip?: React.ReactNode }> = ({
  title,
  subtitle,
  tooltip,
}) => (
  <div>
    <h1 className="flex w-full items-center gap-4 text-left text-5xl font-bold">
      {title}
      {tooltip && <InfoTooltip className="w-71" content={tooltip} />}
    </h1>
    <h2 className="text-primary w-full text-left font-semibold">{subtitle}</h2>
  </div>
);
