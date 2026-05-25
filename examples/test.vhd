-- VHDL counter module
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
  port (
    clk : in std_logic;
    rst : in std_logic;
    count : out std_logic_vector(7 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal counter_val : unsigned(7 downto 0);
begin

  process (clk, rst)
  begin
    if rst = '1' then
      counter_val <= (others => '0');
    elsif rising_edge(clk) then
      counter_val <= counter_val + 1;
    end if;
  end process;

  count <= std_logic_vector(counter_val);

end architecture rtl;
