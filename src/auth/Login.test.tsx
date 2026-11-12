import { fireEvent, render, screen } from "@testing-library/react";
import Login from "./Login";

const signInWithOtp = vi.fn();

vi.mock("./supabase", () => ({
  loadSupabase: async () => ({ auth: { signInWithOtp } }),
}));

beforeEach(() => {
  signInWithOtp.mockReset();
});

function submit(email = "me@example.com") {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
}

test("shows an email field and a send button", () => {
  render(<Login />);
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
});

test("a sent link shows the check-your-email state", async () => {
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  render(<Login />);
  submit();
  expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  expect(signInWithOtp).toHaveBeenCalledWith({ email: "me@example.com" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a refused request keeps the form and shows the error", async () => {
  signInWithOtp.mockResolvedValue({ data: {}, error: { message: "email rate limit exceeded" } });
  render(<Login />);
  submit();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't send the link: email rate limit exceeded");
  expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toHaveValue("me@example.com");
  expect(screen.getByRole("button", { name: /send/i })).toBeEnabled();
});

test("a thrown failure (network) shows the error too", async () => {
  signInWithOtp.mockRejectedValue(new Error("Failed to fetch"));
  render(<Login />);
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't send the link: Failed to fetch");
  expect(screen.getByRole("button", { name: /send/i })).toBeEnabled();
});

test("the button is disabled while the request is in flight", async () => {
  signInWithOtp.mockReturnValue(new Promise(() => {}));
  render(<Login />);
  submit();
  const button = screen.getByRole("button", { name: /send/i });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  await Promise.resolve();
  expect(button).toBeDisabled();
  expect(signInWithOtp).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument();
});
