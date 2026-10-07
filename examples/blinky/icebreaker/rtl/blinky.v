// Blink the red user LED at about 1.4 Hz from the 12 MHz clock.
module blinky (
    input  wire clk,
    output wire led_n
);
    reg [22:0] counter = 0;

    always @(posedge clk)
        counter <= counter + 1;

    // The LED is active low.
    assign led_n = ~counter[22];
endmodule
