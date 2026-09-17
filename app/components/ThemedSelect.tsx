'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

// ============================================================
// ThemedSelect
//
// A drop-in replacement for a small native <select> whose OPEN
// menu matches the app theme. A native select's option list is
// drawn by the operating system (blue highlight, system font),
// which can't be styled with CSS — so the trigger looked on-brand
// and the menu didn't.
//
// Visual language is borrowed from the sidebar ClientSwitcher so
// every dropdown in the app opens the same way: light surface,
// strong border, soft shadow, grey hover, bold + check on the
// selected option. Styles live in globals.css under .crm-select.
//
// Accessibility: the trigger is a button with aria-haspopup /
// aria-expanded, the menu is role="listbox" with role="option"
// items. Keyboard: Enter / Space / ArrowDown opens, arrows move,
// Enter selects, Escape or Tab closes, Home / End jump.
// ============================================================

export type ThemedSelectOption = { value: string; label: string };

export default function ThemedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  minWidth = 170,
  disabled = false,
}: {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  minWidth?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Keyboard highlight, separate from the committed value so
  // arrowing through the list doesn't change anything until Enter.
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const selected = options[selectedIndex];

  // Close on any click outside the component.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    const opt = options[index];
    if (opt) onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  return (
    <div
      ref={rootRef}
      className="crm-select"
      style={{ minWidth }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={`crm-select-trigger ${open ? 'is-open' : ''}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="crm-select-label">{selected?.label ?? ''}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className="crm-select-chevron"
        />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="crm-select-menu"
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`crm-select-option ${
                  isSelected ? 'is-selected' : ''
                } ${i === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
              >
                <span>{o.label}</span>
                {isSelected && (
                  <Check size={14} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
