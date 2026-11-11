import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EmptyState, RangeTabs, SourceBadge, StatTile, TssChip } from ".";

test("SourceBadge names each source", () => {
  render(
    <>
      <SourceBadge source="garmin" />
      <SourceBadge source="peloton" />
      <SourceBadge source="strava_export" />
      <SourceBadge source="strength" />
    </>,
  );
  for (const name of ["Garmin", "Peloton", "Strava", "Strength"]) expect(screen.getByText(name)).toBeInTheDocument();
});

test("TssChip rounds, marks estimates with est. and a dashed border, hides missing", () => {
  const { container, rerender } = render(<TssChip tss={64.6} />);
  expect(screen.getByText("65 TSS")).toHaveClass("border-solid");
  rerender(<TssChip tss={55.2} estimated />);
  const chip = screen.getByText("55 TSS est.");
  expect(chip).toHaveClass("border-dashed");
  expect(chip).toHaveAttribute("data-estimated", "true");
  rerender(<TssChip tss={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("StatTile shows label, value and optional sub-line", () => {
  const { rerender } = render(<StatTile label="Distance" value="64.7 mi" sub="incl. 12.0 mi indoor" />);
  expect(screen.getByText("Distance")).toBeInTheDocument();
  expect(screen.getByText("64.7 mi")).toBeInTheDocument();
  expect(screen.getByText("incl. 12.0 mi indoor")).toBeInTheDocument();
  rerender(<StatTile label="Time" value="3h 28m" />);
  expect(screen.queryByText(/incl\./)).not.toBeInTheDocument();
});

test("EmptyState links to Settings", () => {
  render(
    <MemoryRouter>
      <EmptyState />
    </MemoryRouter>,
  );
  expect(screen.getByText(/No rides yet\. The sync fills this in; see/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
});

test("RangeTabs selects and reports changes", () => {
  const onChange = vi.fn();
  render(
    <RangeTabs
      ariaLabel="Range"
      value="90d"
      onChange={onChange}
      options={[
        { value: "30d", label: "30 d" },
        { value: "90d", label: "90 d" },
        { value: "all", label: "All", disabled: true },
      ]}
    />,
  );
  expect(screen.getByRole("tablist", { name: "Range" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "90 d" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "30 d" }));
  expect(onChange).toHaveBeenCalledWith("30d");
  expect(screen.getByRole("tab", { name: "All" })).toBeDisabled();
});
