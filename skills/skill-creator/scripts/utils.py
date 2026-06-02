"""Shared utilities for skill-creator scripts."""

from pathlib import Path


def parse_skill_md(skill_path: Path) -> tuple[str, str, str]:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    content = (skill_path / "SKILL.md").read_text()
    lines = content.split("\n")

    if lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    name = ""
    description = ""
    frontmatter_lines = lines[1:end_idx]
    i = 0
    while i < len(frontmatter_lines):
        line = frontmatter_lines[i]
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip('"').strip("'")
        elif line.startswith("description:"):
            value = line[len("description:"):].strip()
            # Handle YAML multiline indicators (>, |, >-, |-)
            if value in (">", "|", ">-", "|-"):
                continuation_lines: list[str] = []
                i += 1
                while i < len(frontmatter_lines) and (frontmatter_lines[i].startswith("  ") or frontmatter_lines[i].startswith("\t")):
                    continuation_lines.append(frontmatter_lines[i].strip())
                    i += 1
                description = " ".join(continuation_lines)
                continue
            else:
                description = value.strip('"').strip("'")
        i += 1

    return name, description, content


def update_skill_description(skill_path: Path, new_description: str) -> None:
    """Update the description field in SKILL.md frontmatter in place.

    Rewrites the file with the new description, preserving all other content.
    """
    skill_md = skill_path / "SKILL.md"
    content = skill_md.read_text()
    lines = content.split("\n")

    if lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    # Find frontmatter boundaries
    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    frontmatter = lines[1:end_idx]
    body = lines[end_idx + 1:]

    # Find and replace the description line(s)
    new_frontmatter = []
    in_multiline_desc = False
    desc_replaced = False

    for line in frontmatter:
        if in_multiline_desc:
            if line and (line[0] == ' ' or line[0] == '\t'):
                # Skip continuation lines of the old description
                continue
            else:
                in_multiline_desc = False

        if line.startswith("description:"):
            value = line[len("description:"):].strip()
            if value in (">", "|", ">-", "|-"):
                # Multiline - will skip next indented lines
                in_multiline_desc = True
                # Replace with inline description
                new_frontmatter.append(f"description: {new_description}")
                desc_replaced = True
            else:
                new_frontmatter.append(f"description: {new_description}")
                desc_replaced = True
        else:
            new_frontmatter.append(line)

    if not desc_replaced:
        # No description found - should not happen for valid skills, but handle gracefully
        # Insert after name if it exists
        name_idx = None
        for i, line in enumerate(new_frontmatter):
            if line.startswith("name:"):
                name_idx = i
                break
        if name_idx is not None:
            new_frontmatter.insert(name_idx + 1, f"description: {new_description}")
        else:
            new_frontmatter.insert(0, f"description: {new_description}")

    # Reconstruct the file
    new_content = "---\n" + "\n".join(new_frontmatter) + "\n---\n" + "\n".join(body)
    if body:
        new_content += "\n"

    skill_md.write_text(new_content)
