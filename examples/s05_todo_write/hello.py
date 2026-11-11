"""Simple greeting example (session 05)."""


def greet(name: str) -> None:
    """Print a greeting message for the given name.

    Args:
        name: The name of the person to greet.
    """
    message = "Hello, " + name
    print(message)


def main() -> None:
    """Entry point: greet a sample user."""
    greet("Claude")

