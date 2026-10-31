import sys

def check_braces(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        text = f.read()

    stack = []
    lines = text.split('\n')
    for i, line in enumerate(lines):
        # Extremely primitive! Ignores strings and comments. Just a rough heuristic.
        for j, char in enumerate(line):
            if char in '{[(':
                stack.append((char, i+1))
            elif char in ')]}':
                if not stack:
                    print(f"Error: unmatched {char} at line {i+1}")
                    return
                top, _ = stack.pop()
                if (top == '{' and char != '}') or (top == '[' and char != ']') or (top == '(' and char != ')'):
                    print(f"Error: mismatched {top} and {char} at line {i+1}")
                    return

    if stack:
        print(f"Error: unclosed braces/brackets left: {stack}")
    else:
        print("Braces seem balanced (roughly)")

check_braces('js/alchemy_planner.js')
