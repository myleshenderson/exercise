import { render, screen } from "@testing-library/react";
import Login from "./Login";

test("shows an email field and a send button", () => {
  render(<Login />);
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
});
